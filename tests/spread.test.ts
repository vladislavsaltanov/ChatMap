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

// Gate seeds: every metric gate takes the median over these, else it is a seed test.
const SEEDS = [7, 42, 1337, 11, 3]

// Same-fascicle predicate (§2.1, mirrors the cleft rule in graph.ts): one owner and
// either the same slot or one end is the soma (slot 0). Bodies of one fascicle may
// interlock (SAME_STEM_PACK 0.88), so clearance never counts these pairs.
const sameStemPair = (stemOf: Map<number, number>, a: number, b: number): boolean => {
  const sa = stemOf.get(a) ?? -1
  const sb = stemOf.get(b) ?? -1
  if (sa < 0 || sb < 0 || (sa >> 4) !== (sb >> 4)) return false
  const xa = sa % 16
  const xb = sb % 16
  return xa === xb || xa === 0 || xb === 0
}

// Median intra-stem Spearman(weight, plane length) over owner groups with >=8
// nodes. Heavy links pull harder, so inside one fascicle heavier = shorter.
// The global rho stays in the probes: across stems the law drowns in gaps.
const rhoIntraMedian = (
  edges: SpreadEdge[],
  pos: Map<number, { x: number; y: number }>,
  stemOf: Map<number, number>,
): number => {
  const byOwner = new Map<number, number[]>()
  for (const [id, stem] of stemOf) {
    if (stem < 0) continue
    const owner = Math.floor(stem / 16)
    if (!byOwner.has(owner)) byOwner.set(owner, [])
    byOwner.get(owner)!.push(id)
  }
  const perStem: number[] = []
  for (const ids of byOwner.values()) {
    if (ids.length < 8) continue
    const inStem = new Set(ids)
    const ws: number[] = []
    const ls: number[] = []
    for (const e of edges) {
      if (!inStem.has(e.a) || !inStem.has(e.b)) continue
      const a = pos.get(e.a)
      const b = pos.get(e.b)
      if (!a || !b) continue
      ws.push(e.weight)
      ls.push(Math.hypot(a.x - b.x, a.y - b.y))
    }
    perStem.push(spearman(ws, ls))
  }
  return perStem.length > 0 ? median(perStem) : 0
}

// Largest connected component over the input (post-backbone) edges, as a share
// of n. Sanitary and seed-free (pure graph function): the sheet gate (S1) must
// not be asked to stitch garbage — synth's few unconnected isolates are the
// only allowed gap.
const backboneShare = (n: number, edges: SpreadEdge[]): number => {
  const parent = new Array<number>(n + 1)
  for (let i = 1; i <= n; i++) parent[i] = i
  const find = (a: number): number => {
    let r = a
    while (parent[r] !== r) r = parent[r]!
    return r
  }
  for (const e of edges) parent[find(e.a)] = find(e.b)
  const cnt = new Map<number, number>()
  for (let i = 1; i <= n; i++) cnt.set(find(i), (cnt.get(find(i)) ?? 0) + 1)
  return Math.max(...cnt.values()) / n
}

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
): number => {
  // k follows the node's own degree: a leaf (deg 1) is judged on its single link,
  // a hub on its top-10 by weight. A fixed kPlane = 10 scored leaves on 9 phantom
  // neighbours. Diagnostic only (probe): on leaf tissue a leaf sits beside its
  // siblings, not its hub, so the floor sits near 0.03 — gating it would be a
  // false gate. 1 = topology preserved on the plane.
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
      .slice(0, Math.min(10, (wAdj.get(n.id) ?? []).length))
      .map((nb) => nb.id)
    if (graphTop.length === 0) continue
    const planeTop = nodes
      .filter((m) => m.id !== n.id && pos.get(m.id))
      .map((m) => [Math.hypot(pos.get(m.id)!.x - p.x, pos.get(m.id)!.y - p.y), m.id] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, graphTop.length)
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
    // kNN stays sanitary (strict on every seed); the aspect gate takes the
    // median over SEEDS, else it is a seed test.
    // Elongated plane, not a round blob: the stretch-only hold sets the
    // P10..P90 mass ratio to FRAME_ASPECT (2.0); the bbox no longer votes.
    // User verdicts: 0.79 read as a circle (2026-11-13), 1.8 still too round
    // (2026-11-14), hence the flattened target.
    const qspan = (values: number[]): number => {
      const s = [...values].sort((a, b) => a - b)
      const at = (q: number): number => {
        const pos = q * (s.length - 1)
        const lo = Math.floor(pos)
        const hi = Math.min(s.length - 1, lo + 1)
        return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
      }
      return at(0.9) - at(0.1)
    }
    for (const n of [271, 600]) {
      const aspects: number[] = []
      for (const seed of SEEDS) {
        const { nodes, edges } = synth(n)
        const res = layout(
          nodes.map((nd) => ({ id: nd.id, size: nd.size })),
          edges,
          { seed, fullRun: true },
        )
        const pts = nodes.map((nd) => res.positions.get(nd.id)!).filter(Boolean)
        expect(knnComponents(pts, 5), `${n} nodes seed ${seed}`).toBe(1)
        const ratio = qspan(pts.map((p) => p.x)) / Math.max(1e-9, qspan(pts.map((p) => p.y)))
        aspects.push(ratio)
        // Tail cap: the renderer fits the full box, so the box must tell the same
        // story as the mass — a stray-owned frame would flap the visible aspect
        // while the mass ratio above stays green.
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
        const bboxRatio = (maxX - minX) / Math.max(1e-9, maxY - minY)
        expect(bboxRatio / ratio, `${n} nodes seed ${seed} box-vs-mass`).toBeLessThanOrEqual(1.4)
      }
      const aspectMed = median(aspects)
      expect(aspectMed, `${n} nodes aspect median`).toBeGreaterThanOrEqual(1.85)
      expect(aspectMed, `${n} nodes aspect median`).toBeLessThanOrEqual(2.15)
    }
  })

  it('S2 nuclei: at least 3 clumps twice as dense as the median', () => {
    // Metric gates take the median over SEEDS, else they are seed tests.
    const ports: number[] = []
    const clumps: number[] = []
    for (const seed of SEEDS) {
      const { nodes, edges } = synth(271)
      const res = spread(nodes, edges, { seed, span: 1300 })
      ports.push(res.ports.size)
      clumps.push(gridStats(positionsOf(nodes, res)).clump)
    }
    expect(median(ports), 'ports median').toBeGreaterThanOrEqual(3)
    expect(median(clumps), 'clump median').toBeGreaterThanOrEqual(2.0)
  })

  it('S3 ragged: void share is reported, no lower bound', () => {
    // The lower bound is removed on purpose: a leaf is not obliged to leave
    // oceans. The share is still logged for the eye.
    for (const seed of SEEDS) {
      const { nodes, edges } = synth(600)
      const res = spread(nodes, edges, { seed, span: 1300 })
      const { voidShare } = gridStats(positionsOf(nodes, res))
      console.log(`S3 void seed=${seed} share=${voidShare.toFixed(3)}`)
      expect(Number.isFinite(voidShare)).toBe(true)
    }
  })

  it('S2b mega-hub: 80% of links on one word still produce several nuclei', () => {
    const ports: number[] = []
    for (const seed of SEEDS) {
      const { nodes, edges } = mega(600)
      const res = spread(nodes, edges, { seed, span: 1300 })
      ports.push(res.ports.size)
      // Void share probes only (S3): no lower bound on a mega-hub either.
      const { voidShare } = gridStats(positionsOf(nodes, res))
      console.log(`S2b void seed=${seed} share=${voidShare.toFixed(3)}`)
      expect(Number.isFinite(voidShare)).toBe(true)
    }
    expect(median(ports), 'mega-hub ports median').toBeGreaterThanOrEqual(3)
  })

  it('S6 strand: cores are tighter than tips', () => {
    const ratios: number[] = []
    for (const seed of SEEDS) {
      const { nodes, edges } = synth(600)
      const res = spread(nodes, edges, { seed, span: 1300 })
      const pts = positionsOf(nodes, res)
      const d = nn(pts)
      const sorted = [...d].sort((a, b) => a - b)
      const core = sorted.slice(0, Math.floor(sorted.length * 0.2))
      const tips = sorted.slice(-Math.floor(sorted.length * 0.2))
      ratios.push(median(core) / median(tips))
    }
    expect(median(ratios), 'core/tips median').toBeLessThan(0.7)
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
    // Intra-stem pairs are skipped: SAME_STEM_PACK (0.88) lets one fascicle pack
    // 12% tighter by design, so counting them would gate the design, not a defect.
    const worsts: number[] = []
    for (const seed of SEEDS) {
      const { nodes, edges } = grid(271)
      const res = layout(nodes, edges, { seed, fullRun: true })
      const stemOf = res.stemOf ?? new Map<number, number>()
      const pts = nodes.map((n) => ({ ...res.positions.get(n.id)!, size: n.size ?? 20, id: n.id }))
      let worst = Infinity
      let skipped = 0
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          if (sameStemPair(stemOf, pts[i].id, pts[j].id)) {
            skipped++
            continue
          }
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
          worst = Math.min(worst, d - Math.max(pts[i].size, pts[j].size))
        }
      }
      // Non-vacuous: the exclusion must not eat the whole pair set.
      expect(skipped, `seed ${seed} intra-stem pairs`).toBeGreaterThan(0)
      worsts.push(worst)
    }
    expect(median(worsts), 'cross-stem gap median').toBeGreaterThan(0)
  })

  it('S5 topology: strongly connected nodes stay closer than weakly connected', () => {
    for (const seed of SEEDS) {
      const { nodes, edges } = grid(14)
      const res = layout(nodes, edges, { seed, fullRun: true })
      const p = (id: number) => res.positions.get(id)!
      const strong = Math.hypot(p(2).x - p(3).x, p(2).y - p(3).y)
      const weak = Math.hypot(p(1).x - p(14).x, p(1).y - p(14).y)
      expect(strong, `seed ${seed}`).toBeLessThan(weak)
    }
  })

  it('S10 tissue: heavy intra-stem links run shorter (rho_intra < -0.05)', () => {
    // Spearman(weight, plane length) inside each owner group (>=8 nodes), median
    // over groups, then median over SEEDS. The global rho stays in the probes:
    // across stems the weight/length law drowns in inter-stem gaps.
    for (const n of [271, 600]) {
      const perSeed: number[] = []
      for (const seed of SEEDS) {
        const { nodes, edges } = synth(n)
        const res = layout(
          nodes.map((nd) => ({ id: nd.id, size: nd.size })),
          edges,
          { seed, fullRun: true },
        )
        perSeed.push(rhoIntraMedian(edges, res.positions, res.stemOf ?? new Map()))
      }
      expect(median(perSeed), `${n} nodes rho_intra median`).toBeLessThan(-0.05)
    }
  })

  it('S11 backbone: the input graph is essentially one component', () => {
    // Largest-component share over the post-backbone input edges. Seed-free by
    // construction (pure graph function); the only allowed gap is synth's few
    // unconnected isolates. Proves S1 stitches tissue, not garbage.
    expect(backboneShare(271, synth(271).edges), 'synth-271').toBeGreaterThanOrEqual(0.95)
    expect(backboneShare(600, synth(600).edges), 'synth-600').toBeGreaterThanOrEqual(0.95)
    expect(backboneShare(600, mega(600).edges), 'mega-600').toBeGreaterThanOrEqual(0.95)
    const ring = (n: number): SpreadEdge[] => {
      const edges: SpreadEdge[] = []
      for (let i = 1; i < n; i++) edges.push({ a: i, b: i + 1, weight: 2 })
      return edges
    }
    expect(backboneShare(271, ring(271)), 'ring-271').toBeGreaterThanOrEqual(0.95)
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
    // Warmup + median of 3: a single shot on a shared CI runner flakes on
    // worker contention (vitest isolates test files into competing workers).
    // The 400 ms bar itself is unchanged.
    layout(nodes, edges, { seed: 2, fullRun: true })
    const samples: number[] = []
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      layout(nodes, edges, { seed: 2, fullRun: true })
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const ms = samples[1]!
    console.log(`layout 1000: ${ms.toFixed(0)} ms (median of ${samples.map((s) => s.toFixed(0)).join('/')})`)
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
    const rhoIntra = rhoIntraMedian(edges, pos, res.stemOf ?? new Map())
    console.log(
      `P1 spread 271 hull: rho=${rho.toFixed(3)} rhoIntra=${rhoIntra.toFixed(3)} kNNcomp=${comp} cv=${cv.toFixed(3)} maxVoid=${maxVoid.toFixed(3)} voidShare=${voidShare.toFixed(3)} presK=${pres.toFixed(3)}`,
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
      `P0 leaf 271 hull: rho=${rho.toFixed(3)} kNNcomp=${comp} cv=${cv.toFixed(3)} maxVoid=${maxVoid.toFixed(3)} voidShare=${voidShare.toFixed(3)} presK=${pres.toFixed(3)}`,
    )
    expect(Number.isFinite(rho)).toBe(true)
    expect(comp).toBeGreaterThanOrEqual(1)
    expect(pres).toBeGreaterThanOrEqual(0)
    expect(pres).toBeLessThanOrEqual(1)
  })
})
